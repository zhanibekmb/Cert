/* =====================================================================
   CERT — tiny i18n helper. Inline bilingual strings via T(en, ru).
   Shares the 'cert_lang' key with the landing page.
   ===================================================================== */
(function (global) {
  'use strict';
  var lang = localStorage.getItem('cert_lang') || 'en';

  var I = {
    get lang() { return lang; },
    set: function (l) {
      lang = (l === 'ru') ? 'ru' : 'en';
      localStorage.setItem('cert_lang', lang);
      document.documentElement.lang = lang;
      if (global.CertStore) global.CertStore.setLang(lang);
    },
    toggle: function () { I.set(lang === 'en' ? 'ru' : 'en'); }
  };

  global.CertI18n = I;
  global.T = function (en, ru) { return lang === 'ru' ? ru : en; };
})(window);
