// Applies the saved theme before first paint, so a light-theme user never
// sees a dark flash. A file, not an inline script, so the CSP can forbid
// inline scripts outright.
(function () {
  var t = "dark";
  try { t = localStorage.getItem("techi.theme") || "dark"; } catch (e) { /* storage blocked */ }
  if (t === "system") {
    t = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.classList.add(t);
  document.documentElement.style.colorScheme = t;
  // Window chrome (installed-app title bar, mobile status bar) matches the
  // top bar. Same values as THEME_CHROME_COLOR in src/contexts/ThemeContext.tsx.
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", t === "light" ? "#ffffff" : "#131316");
})();
