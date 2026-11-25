export function isUiPreview() {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";
}
