import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureProject, readState, updateState } from './state.mjs';
import { preparePage, runActions, settle, withBrowser, renderedScreenshot } from './browser.mjs';
import { svgStyleProperties, svgChanges, validateSvgComparison, comparisonPixels, svgElementScreenshot } from './svg.mjs';
import { installedVersions } from './maintenance.mjs';

export const styleProperties = ['display', 'position', 'box-sizing', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'top', 'right', 'bottom', 'left', 'transform', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'align-items', 'align-self', 'justify-content', 'gap', 'row-gap', 'column-gap', 'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row', 'overflow-x', 'overflow-y', 'font-family', 'font-size', 'line-height', 'text-align', 'white-space', 'z-index', 'opacity', 'visibility', 'color', 'background-color'];

const inheritedProperties = new Set(['font-family', 'font-size', 'line-height', 'color', 'text-align', 'white-space', 'visibility']);
const primaryStyles = ['display', 'width', 'height', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'gap', 'flex-direction', 'grid-template-columns'];
const safeTime = () => new Date().toISOString().replace(/[:.]/g, '-');

function sourceFor(header, property, rule) {
  // CDP のスタイルシート情報を人が追える出所と行番号にする。
  const origin = header?.origin || rule?.origin;
  const sourceName = header?.sourceURL || (origin === 'user-agent' ? 'user agent' : 'inline <style>');

  if (sourceName === 'user agent') {
    return sourceName;
  }

  const localLine = property.range?.startLine ?? rule?.style?.range?.startLine ?? 0;
  const line = (header?.startLine ?? 0) + localLine + 1;
  return `${sourceName}:${line}`;
}

function physicalProperty(name, computed) {
  const writing = computed.get('writing-mode') || 'horizontal-tb';
  const vertical = /^(vertical|sideways)-/.test(writing);
  let inline = vertical ? ['top', 'bottom'] : ['left', 'right'];
  if (writing === 'sideways-lr') inline.reverse();
  if (computed.get('direction') === 'rtl') inline.reverse();
  const block = vertical ? (writing.endsWith('-rl') ? ['right', 'left'] : ['left', 'right']) : ['top', 'bottom'];
  const size = name.match(/^(min-|max-)?(inline|block)-size$/);
  if (size) return `${size[1] || ''}${(size[2] === 'inline') !== vertical ? 'width' : 'height'}`;
  const edge = name.match(/^(margin|padding|inset|border)-(inline|block)-(start|end)(.*)$/);
  if (!edge) return name;
  const side = (edge[2] === 'inline' ? inline : block)[edge[3] === 'start' ? 0 : 1];
  return `${edge[1] === 'inset' ? '' : `${edge[1]}-`}${side}${edge[4]}`;
}

function propertyTargets(property, computed) {
  // ショートハンドを含む宣言が影響する長いプロパティを列挙する。
  const shorthand = {
    margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
    padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']
  };
  const names = [property.name, ...(property.longhandProperties || []).map((longhand) => longhand.name), ...(shorthand[property.name] || [])];
  return [...new Set(names.map(name => physicalProperty(name, computed)).filter((name) => styleProperties.includes(name)))];
}

function declaredValue(declaration) {
  // 展開後の値でなく、同じ位置に書かれた元の宣言を保存する。
  const value = declaration.value || declaration.text?.replace(/^[^:]+:\s*/, '') || '';
  return value.replace(/\s*!\s*important\s*;?$/i, '').trim();
}

function declarations(style) {
  const properties = style?.cssProperties || [];
  // CDP は記述順の宣言に加えてCSSOMの要約を末尾へ付ける。
  // 要約をもう一度走査すると論理指定やショートハンドの順番を失う。
  const authored = properties.filter(property => property.range || property.text);
  return (authored.length ? authored : properties).filter(property => !property.disabled && property.parsedOk !== false);
}

function higherPriority(candidate, previous) {
  if (!previous) return true;
  for (let index = 0; index < candidate.rank.length; index++) {
    if (candidate.rank[index] !== previous.rank[index]) return candidate.rank[index] > previous.rank[index];
  }
  return false;
}

function chooseCandidate(best, candidate) {
  const slot = candidate.important ? 'important' : 'normal';
  if (higherPriority(candidate, best[slot])) best[slot] = candidate;
}

function layerKey(rule) {
  return [...(rule.layers || [])].reverse().map(layer => layer.text ||
    `anonymous:${layer.styleSheetId}:${layer.range?.startLine}:${layer.range?.startColumn}`).join('.');
}

function candidatesFromRules(rules, headers, computed, inheritedFrom) {
  // CDP の通常優先順を保ち、important の層順だけ逆転する。
  const found = new Map();
  const layers = new Map();
  for (const [index, item] of (rules || []).entries()) {
    const rule = item.rule || item;
    const key = `${rule.origin}:${layerKey(rule)}`;
    if (!layers.has(key)) layers.set(key, index);
  }
  for (const [ruleIndex, item] of (rules || []).entries()) {
    const rule = item.rule || item;
    const selector = rule.selectorList?.text || 'style attribute';
    const header = headers.get(rule.styleSheetId || rule.style?.styleSheetId);
    for (const [declarationIndex, declaration] of declarations(rule.style).entries()) {
      const important = Boolean(declaration.important);
      const origin = rule.origin === 'user-agent' ? (important ? 2 : 0) : 1;
      const layer = important ? (rule.layers?.length ? -layers.get(`${rule.origin}:${layerKey(rule)}`) : -Infinity) : 0;
      for (const property of propertyTargets(declaration, computed)) {
        const best = found.get(property) || {};
        chooseCandidate(best, {
          property,
          declared: declaredValue(declaration),
          selector,
          source: sourceFor(header, declaration, rule),
          important,
          rank: [origin, 0, layer, ruleIndex, declarationIndex],
          ...(inheritedFrom ? { inheritedFrom } : {})
        });
        found.set(property, best);
      }
    }
  }

  return found;
}

function candidatesFromInline(style, computed) {
  // style 属性を通常宣言の最優先候補として読む。
  const found = new Map();

  for (const [index, declaration] of declarations(style).entries()) {
    for (const property of propertyTargets(declaration, computed)) {
      const best = found.get(property) || {};
      chooseCandidate(best, {
        property,
        declared: declaredValue(declaration),
        selector: 'style attribute',
        source: 'inline style',
        important: Boolean(declaration.important),
        rank: [1, 1, 0, 0, index]
      });
      found.set(property, best);
    }
  }

  return found;
}

function selectedCandidates(ruleCandidates, inlineCandidates) {
  // 規則候補と style 属性候補から最終宣言を一つ選ぶ。
  const selected = new Map();

  for (const property of styleProperties) {
    const rule = ruleCandidates.get(property) || {};
    const inline = inlineCandidates.get(property) || {};
    const strongest = (left, right) => !left ? right : !right || higherPriority(left, right) ? left : right;
    const candidate = strongest(inline.important, rule.important) || strongest(inline.normal, rule.normal);

    if (candidate) {
      selected.set(property, candidate);
    }
  }

  return selected;
}

async function cascadeFor(page, selector) {
  // CDP の適用規則から計算後スタイルの原因候補を求める。
  const cdp = await page.context().newCDPSession(page);
  const headers = new Map();
  cdp.on('CSS.styleSheetAdded', ({ header }) => headers.set(header.styleSheetId, header));

  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const document = await cdp.send('DOM.getDocument');
    const query = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector });

    if (!query.nodeId) {
      return [];
    }

    const matched = await cdp.send('CSS.getMatchedStylesForNode', { nodeId: query.nodeId });
    const computed = new Map((await cdp.send('CSS.getComputedStyleForNode', { nodeId: query.nodeId })).computedStyle.map(({ name, value }) => [name, value]));
    const direct = selectedCandidates(candidatesFromRules(matched.matchedCSSRules, headers, computed), candidatesFromInline(matched.inlineStyle, computed));
    const inherited = new Map();

    for (const ancestor of matched.inherited || []) {
      const inheritedRules = candidatesFromRules(ancestor.matchedCSSRules, headers, computed);
      const inheritedInline = candidatesFromInline(ancestor.inlineStyle, computed);
      const selected = selectedCandidates(inheritedRules, inheritedInline);

      for (const property of inheritedProperties) {
        if (!inherited.has(property) && selected.has(property)) {
          const candidate = selected.get(property);
          inherited.set(property, { ...candidate, inheritedFrom: candidate.selector });
        }
      }
    }

    const cascade = [];

    for (const property of styleProperties) {
      const candidate = direct.get(property) || (inheritedProperties.has(property) ? inherited.get(property) : null);

      if (candidate) {
        const { rank, ...source } = candidate;
        cascade.push({ ...source, computed: computed.get(property) || '' });
      }
    }

    return cascade;
  } finally {
    await cdp.detach();
  }
}

function recordChange(changes, width, path, before, after) {
  // 値が変わった項目だけを差分結果へ追加する。
  if (before !== after) {
    changes.push({ width, path, before, after });
  }
}

function compare(previous, current) {
  // 同じ対象・画面幅の計測結果から位置と主要スタイルの差分を作る。
  if (!previous?.widths) {
    return undefined;
  }

  const changes = [];

  for (const entry of current.widths) {
    const before = previous.widths.find((item) => item.width === entry.width);

    if (!before) {
      continue;
    }

    for (const property of styleProperties) {
      recordChange(changes, entry.width, `target.styles.${property}`, before.target?.styles?.[property], entry.target?.styles?.[property]);
    }

    for (const property of ['x', 'y', 'width', 'height']) {
      recordChange(changes, entry.width, `target.rect.${property}`, before.target?.rect?.[property], entry.target?.rect?.[property]);
    }

    if (entry.target.svg) {
      changes.push(...svgChanges(before.target?.svg, entry.target.svg).map((change) => ({ width: entry.width, ...change })));
      for (const property of svgStyleProperties) recordChange(changes, entry.width, `target.styles.${property}`, before.target?.styles?.[property], entry.target.styles[property]);
    }

    for (const parent of entry.parents || []) {
      const oldParent = before.parents?.find((item) => item.depth === parent.depth);

      for (const property of ['x', 'y', 'width', 'height']) {
        recordChange(changes, entry.width, `parents.${parent.depth}.rect.${property}`, oldParent?.rect?.[property], parent.rect?.[property]);
      }

      for (const property of primaryStyles) {
        recordChange(changes, entry.width, `parents.${parent.depth}.styles.${property}`, oldParent?.styles?.[property], parent.styles?.[property]);
      }
    }
  }

  return { at: previous.at, label: previous.label, changes };
}

export async function measure({ config, url, selector, widths = config.widths, parents = 2, actions, label, baseUrl, comparisonKey = url }) {
  // 画面幅ごとに対象・親・カスケード・画像を実測して保存する。
  const dir = await ensureProject(config.root);
  const at = new Date().toISOString();
  const stamp = safeTime();
  const shots = path.join(dir, 'shots');
  await fs.mkdir(shots, { recursive: true });

  const result = {
    at,
    toolchain: await installedVersions(),
    url,
    selector,
    ...(label ? { label } : {}),
    widths: []
  };

  if (config._svgMode) {
    if (!Array.isArray(config.comparisonSelectors) || !config.comparisonSelectors.length || config.comparisonSelectors.includes(selector)) throw new Error('SVG measurement requires comparisonSelectors containing at least one separate unchanged target.');
    result.svgConditions = { comparisonKey, selector, widths, actions: actions || '', comparisonSelectors: config.comparisonSelectors, toolchain: await installedVersions() };
  }

  await withBrowser(async (browser) => {
    for (const width of widths) {
      const page = await preparePage(browser, width, config);

      try {
        const settled = await settle(page, url);
        await runActions(page, actions, baseUrl);
        const data = await page.evaluate(({ selected, count, properties, svgMode, comparisonSelectors }) => {
          const describe = (node, depth = 0) => {
            const rect = node.getBoundingClientRect();
            const css = getComputedStyle(node);
            const styles = Object.fromEntries(properties.map((name) => [name, css.getPropertyValue(name)]));
            const description = {
              depth,
              tag: node.tagName.toLowerCase(),
              id: node.id,
              class: typeof node.className === 'string' ? node.className : '',
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              styles
            };
            if (svgMode && node.namespaceURI === 'http://www.w3.org/2000/svg') {
              description.class = node.getAttribute('class') || '';
              const svgRoot = node.ownerSVGElement || node;
              const viewport = svgRoot.getBoundingClientRect();
              const matrix = node.getScreenCTM?.();
              const box = typeof node.getBBox === 'function' ? node.getBBox() : null;
              description.svg = {
                // getBBox is geometry in local SVG units, not the painted
                // pixel bounds of strokes, filters or glyphs.
                geometryBox: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
                screenMatrix: matrix ? { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f } : null,
                viewBox: svgRoot.getAttribute('viewBox'), preserveAspectRatio: svgRoot.getAttribute('preserveAspectRatio'),
                viewport: { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height },
                attributes: Object.fromEntries([...node.attributes].map((attribute) => [attribute.name, attribute.value])),
                markup: node.outerHTML,
                ...(typeof node.getComputedTextLength === 'function' ? { text: node.textContent, renderedTextLength: node.getComputedTextLength() } : {})
              };
            }
            return description;
          };
          const nodes = [...document.querySelectorAll(selected)];

          if (!nodes.length) {
            return { matched: 0 };
          }

          const target = nodes[0];
          if (svgMode && (nodes.length !== 1 || target.namespaceURI !== 'http://www.w3.org/2000/svg')) throw new Error('SVG target must select exactly one SVG element.');
          const targetData = describe(target);
          targetData.visible = typeof target.checkVisibility === 'function'
            ? target.checkVisibility({ visibilityProperty: true })
            : targetData.styles.display !== 'none' && !['hidden', 'collapse'].includes(targetData.styles.visibility) && target.getClientRects().length > 0;
          delete targetData.depth;
          const parentList = [];
          let parent = target.parentElement;

          for (let depth = 1; parent && depth <= count; depth++, parent = parent.parentElement) {
            parentList.push(describe(parent, depth));
          }

          const comparisons = [];
          for (const selector of comparisonSelectors || []) {
            const matches = document.querySelectorAll(selector);
            if (matches.length !== 1 || matches[0] === target || target.contains(matches[0]) || matches[0].contains(target)) throw new Error('Each SVG comparison selector must identify one separate target.');
            const node = matches[0];
            const measured = describe(node);
            const paintedLine = measured.styles.stroke !== 'none' && parseFloat(measured.styles['stroke-width']) > 0;
            if (measured.styles.display === 'none' || measured.styles.visibility !== 'visible' || Number(measured.styles.opacity) === 0 || (!paintedLine && (measured.rect.width <= 0 || measured.rect.height <= 0))) throw new Error('SVG comparison target is hidden or has no measurable area.');
            comparisons.push({ selector, ...measured });
          }
          return { matched: nodes.length, target: targetData, parents: parentList, ...(svgMode ? { comparisons } : {}) };
        }, { selected: selector, count: parents, properties: config._svgMode ? [...styleProperties, ...svgStyleProperties] : styleProperties, svgMode: Boolean(config._svgMode), comparisonSelectors: config._svgMode ? config.comparisonSelectors : [] });

        if (!data.matched) {
          throw new Error('No element matches the selector');
        }

        const screenshot = path.join(shots, `${stamp}-${width}.png`);
        const elementShot = data.target.visible ? path.join(shots, `${stamp}-${width}-el.png`) : null;
        await renderedScreenshot(page, screenshot, config);

        if (elementShot) {
          if (config._svgMode) await svgElementScreenshot(page, selector, elementShot);
          else await page.locator(selector).first().screenshot({ path: elementShot });
        }

        if (config._svgMode && (!data.target.visible || data.target.styles.visibility !== 'visible' || Number(data.target.styles.opacity) === 0)) throw new Error('SVG target is hidden; a rendered measurement is required.');

        const comparisonShots = [];
        if (config._svgMode) {
          for (const [index, comparison] of data.comparisons.entries()) {
            const file = path.join(shots, `${stamp}-${width}-comparison-${index}.png`);
            comparison.pixelHash = await comparisonPixels(page, comparison, file);
            comparisonShots.push(file);
          }
        }

        result.widths.push({
          width,
          height: await page.evaluate(() => innerHeight),
          settled,
          target: { matched: data.matched, ...data.target },
          parents: data.parents,
          cascade: await cascadeFor(page, selector),
          screenshot,
          elementShot,
          ...(config._svgMode ? { comparisons: data.comparisons, comparisonShots } : {})
        });
      } finally {
        await page.close();
      }
    }
  });

  const state = await readState(config.root);
  let previous;

  if ((state.lastMeasure?.comparisonKey || state.lastMeasure?.url) === comparisonKey && state.lastMeasure?.selector === selector && state.lastMeasure.path) {
    try {
      previous = JSON.parse(await fs.readFile(state.lastMeasure.path, 'utf8'));
    } catch {
      // begin 後に前回の結果が消えている場合は差分なしにする。
    }
  }

  if (!config._svgMode && previous?.toolchain && (state.pendingMeasure || label === 'after') && JSON.stringify(previous.toolchain) !== JSON.stringify(result.toolchain)) throw new Error('Measurement tool versions changed during the CSS comparison. Re-establish the baseline with the current tools; pending edits remain unverified.');

  const comparison = compare(previous, result);

  if (config._svgMode) {
    if ((state.pendingMeasure || label === 'after') && !previous) throw new Error('A matching SVG before measurement is required; changing targets cannot clear pending edits.');
    validateSvgComparison(previous, result);
  }

  if (comparison) {
    result.previous = comparison;
  }

  const output = path.join(dir, 'measures', `${stamp}.json`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  await updateState(config.root, (current) => ({
    ...current,
    lastMeasureAt: at,
    lastMeasure: { url, comparisonKey, selector, widths, actions: actions || '', path: output },
    pendingMeasure: current.pendingMeasure && !(
      (current.pendingMeasure.comparisonKey || current.pendingMeasure.url) === comparisonKey &&
      current.pendingMeasure.selector === selector &&
      (current.pendingMeasure.actions || '') === (actions || '') &&
      current.pendingMeasure.widths.every((width) => widths.includes(width)) &&
      Date.parse(at) >= Date.parse(current.lastCssEditAt)
    ) ? current.pendingMeasure : null
  }));
  return result;
}
