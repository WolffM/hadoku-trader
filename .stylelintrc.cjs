/**
 * Stylelint config — catches `var(--name)` references to custom properties
 * that aren't defined anywhere. @wolffm/themes is the source of truth for
 * color/spacing/radius/etc tokens; this gate prevents typos like
 * `--color-acccent` from silently falling back to unset across themes.
 */
module.exports = {
  plugins: ['stylelint-value-no-unknown-custom-properties'],
  rules: {
    'csstools/value-no-unknown-custom-properties': [
      true,
      {
        importFrom: [require.resolve('@wolffm/themes/style.css')],
      },
    ],
  },
}
