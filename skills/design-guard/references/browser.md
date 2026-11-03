# Browser operations

Use for browsing, input, saving, downloads and functional checks. Read the project's current workflow and state for the target, authorized actions and output locations. Loading this skill does not authorize additional registration, submission or payment.

## Choose the tools

- **Use Chrome DevTools MCP.** Work and verification use a separately managed Chrome for Testing Stable browser, independent of Playwright. Prefer the configured connection for that browser. If the user has selected their everyday browser, follow the project's current workflow and configured Chrome DevTools MCP connection; preserve existing tabs, settings and login state. Do not copy credentials into the work browser.
- Before the day's first applicable managed-Chrome operation, run `render-guard css update`. Share the daily record with CSS/SVG; other sessions and projects that day do not repeat updates or tests. Do not automatically retry failures or change versions or connections mid-operation/comparison. If the CLI or connection is unavailable, investigate and report the affected operation as incomplete.
- **Do not use Playwright.** Do not reinstall its library, MCP server or browsers without a new user instruction. An old script's dependency is not permission to restore it: adapt the necessary work to Chrome within the authorized scope, or report the incompatibility. For repeated scripted operations, reuse the project's existing code and the [shared Chrome API](../../../lib/chrome-automation.mjs).

## Operate and verify

- Inspect the current page before acting and identify its URL and tab. Check the company, account, period or other context that could direct changes to the wrong data.
- Select targets from a fresh snapshot; do not reuse stale identifiers or coordinates. If coordinate input is necessary, inspect the image, display scale and window position first.
- Read back entered values. After saving, registration or downloading, verify the affected record, count or output file as well as the completion message. After a timeout or uncertain response, check whether the operation took effect before retrying, avoiding duplicate records or submissions.
- If appearance is also created or revised, follow SKILL.md to the applicable measurement references. Browser interaction alone does not require CSS scope declarations or dimension measurements.
- Retain required records and outputs, then close work tabs, connections and temporary processes you created. Preserve the user's and others' active work. Report operations whose results could not be verified as incomplete.
