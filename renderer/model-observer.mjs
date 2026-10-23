/** Read only the selected model label in this slot's own composer. */
export function observeComposerModel(root, onChange, Observer = globalThis.MutationObserver) {
  const scope = root?.closest?.(".composer-right");
  let previous;
  const read = () => {
    const label = scope?.querySelector(".composer-model-thinking-model")?.textContent?.trim() || "";
    if (label === previous) return;
    previous = label;
    onChange({ label, gpt: /gpt|codex|chatgpt/i.test(label) });
  };
  read();
  if (!scope || typeof Observer !== "function") return () => {};
  const observer = new Observer(read);
  observer.observe(scope, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-label", "title"],
  });
  // Re-read after attaching to cover a replacement between read and observe.
  read();
  return () => observer.disconnect();
}
