// Keeps the boot preloader's animation continuous when React's AppPreloader
// takes over: both start from page time zero.
(function () {
  var now = performance.now();
  var stack = document.querySelector(".th-preloader__stack");
  var bar = document.querySelector(".th-preloader__bar");
  if (stack) stack.style.animationDelay = Math.round(150 - now) + "ms";
  if (bar) bar.style.animationDelay = -Math.round(now % 1400) + "ms";
})();
