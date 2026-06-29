/* =====================================================================
   CERT — geo-aware pricing. Detects the visitor's currency via IP (free
   ipapi.co lookup) and shows deliberately-set local prices. Falls back to
   USD on any failure. Prices are hand-set per market (not raw FX), so they
   read clean in each currency.
   ===================================================================== */
(function () {
  var FALLBACK = "USD";
  // mo = monthly, yr = yearly, f1/f3/f5 = freeze packs. whole = no decimals.
  var TABLE = {
    USD: { sym: "$",  mo: 4.99,  yr: 29.99, f1: 2,   f3: 5,   f5: 7 },
    EUR: { sym: "€",  mo: 4.99,  yr: 29.99, f1: 2,   f3: 5,   f5: 7 },
    GBP: { sym: "£",  mo: 4.49,  yr: 27.99, f1: 2,   f3: 5,   f5: 6 },
    KZT: { sym: "₸",  mo: 2490,  yr: 14900, f1: 890, f3: 2290, f5: 3290, whole: true },
    RUB: { sym: "₽",  mo: 449,   yr: 2690,  f1: 179, f3: 449, f5: 649, whole: true },
    UAH: { sym: "₴",  mo: 199,   yr: 1190,  f1: 79,  f3: 199, f5: 279, whole: true },
    INR: { sym: "₹",  mo: 399,   yr: 2390,  f1: 159, f3: 399, f5: 559, whole: true },
    TRY: { sym: "₺",  mo: 169,   yr: 990,   f1: 69,  f3: 169, f5: 239, whole: true },
    BRL: { sym: "R$", mo: 24.9,  yr: 149,   f1: 9.9, f3: 24.9, f5: 34.9 },
    PLN: { sym: "zł", mo: 19.9,  yr: 119,   f1: 7.9, f3: 19.9, f5: 27.9 },
    CAD: { sym: "C$", mo: 6.49,  yr: 39.99, f1: 3,   f3: 7,   f5: 9 },
    AUD: { sym: "A$", mo: 7.49,  yr: 44.99, f1: 3,   f3: 7,   f5: 10 },
  };

  var code = FALLBACK, cur = TABLE[FALLBACK], country = "";

  function fmt(n, c) {
    if (c.whole) return c.sym + Math.round(n).toLocaleString("en-US");
    return c.sym + n.toFixed(2);
  }

  window.CertPrice = {
    get code() { return code; },
    get country() { return country; },
    monthly: function () { return fmt(cur.mo, cur); },
    yearly: function () { return fmt(cur.yr, cur); },
    yearlyPerMo: function () { return fmt(cur.yr / 12, cur); },
    freeze: function (k) { return fmt(cur["f" + k], cur); },
    // fetch geo once, then call cb() so the page can re-render with local prices
    load: function (cb) {
      try {
        fetch("https://ipapi.co/json/").then(function (r) { return r.json(); }).then(function (j) {
          if (j) {
            country = j.country_code || j.country || "";
            var c = j.currency || "";
            if (TABLE[c]) { code = c; cur = TABLE[c]; }
          }
          if (cb) cb();
        }).catch(function () { if (cb) cb(); });
      } catch (e) { if (cb) cb(); }
    },
  };
})();
