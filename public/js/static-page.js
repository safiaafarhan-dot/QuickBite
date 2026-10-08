/* Boot script for pages with no behaviour of their own (404, etc.).
   Kept as a file rather than an inline <script> because the Content-Security-
   Policy blocks inline script execution. */
(() => {
  'use strict';
  window.QB.theme.init();
  window.QB.installImageFallback();
})();
