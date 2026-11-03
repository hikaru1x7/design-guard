import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  if (/^(playwright|playwright-core)(\/|$)/.test(specifier) || /\/node_modules\/(playwright|playwright-core)\//.test(specifier)) {
    throw new Error('Playwright is forbidden in Chrome backend validation: ' + specifier);
  }
  return next(specifier, context);
} });
