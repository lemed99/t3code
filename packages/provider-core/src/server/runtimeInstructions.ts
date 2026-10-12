const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.
</pull_request_linking>`;

const DESIGN_CANVAS_INSTRUCTIONS = `<artifacts>
When asked for something the user will look at, keep or share (a design, a document, a sheet), make it an artifact: one folder per artifact in the project's artifacts/ folder, artifacts/<short-name>/. The user sees artifacts in T3 Code's Artifacts panel, and every account working on the project shares them.
- Design (screens, pages, flows, mockups, posters): each screen is one self-contained HTML file in artifacts/<name>/screens/ (inline CSS and JS; images beside it or as data: URLs; no .json, no dot folders), laid out for its frame size with a matching <meta name="viewport" content="width=...">. List the screens in artifacts/<name>/canvas.json: {"title": "...", "pages": [{"name": "...", "sections": [{"title": "...", "frames": [{"file": "screens/<screen>.html", "title": "...", "width": 1440, "height": 900}]}]}]}. Common sizes: desktop 1440x900, iPhone 390x844, Android 412x915. Group a flow in one section, in order; put alternatives on their own page. A set of related screens is one design artifact, not one artifact per screen.
- Document (plan, spec, brief, report, notes): artifacts/<name>/document.md in Markdown, starting with a # title.
- Sheet (table, budget, tracker, list of records): artifacts/<name>/<name>.csv with a header row.
Record each artifact in artifacts/index.json: {"<name>": {"title": "...", "updatedAt": "<ISO 8601 date>"}}, keeping the other entries. To change an artifact, edit its files in place and update updatedAt; for an alternative design, add screens beside the original. Use realistic content, check each screen renders at its size before finishing, and say which artifact you made or changed. Use html_render only for quick visual answers, not for artifacts.
</artifacts>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${DESIGN_CANVAS_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
