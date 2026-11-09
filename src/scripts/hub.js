// hub.js — search + category filter on the hub; no-op on other pages. No deps.
(function () {
  var grid = document.querySelectorAll(".app-card");
  var search = document.getElementById("search");
  var empty = document.getElementById("no-results");
  if (!search || !grid.length) return;
  var activeCat = "";
  var btns = Array.prototype.slice.call(document.querySelectorAll(".cat-btn"));
  function apply() {
    var q = search.value.trim().toLowerCase();
    var shown = 0;
    grid.forEach(function (card) {
      var name = card.getAttribute("data-name") || "";
      var cat = card.getAttribute("data-category") || "";
      var okQ = !q || name.indexOf(q) !== -1;
      var okC = !activeCat || cat === activeCat;
      var show = okQ && okC;
      card.classList.toggle("is-hidden", !show);
      if (show) shown++;
    });
    // hide section headers with no visible cards
    document.querySelectorAll(".app-section").forEach(function (sec) {
      var cards = sec.querySelectorAll(".app-card");
      if (!cards.length) return;
      var anyVisible = Array.prototype.some.call(cards, function (c) {
        return !c.classList.contains("is-hidden");
      });
      sec.style.display = anyVisible ? "" : "none";
    });
    if (empty) empty.hidden = shown !== 0;
  }
  search.addEventListener("input", apply);
  btns.forEach(function (b) {
    b.addEventListener("click", function () {
      activeCat = b.getAttribute("data-cat") || "";
      btns.forEach(function (x) { x.classList.toggle("is-on", x === b); });
      apply();
    });
  });
})();
