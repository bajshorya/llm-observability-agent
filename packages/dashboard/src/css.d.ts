/**
 * Next declares `*.module.css` but not a plain side-effect stylesheet import,
 * which `app/layout.tsx` uses for the single global sheet. This declares it so
 * `tsc --noEmit` passes; the bundler handles the import either way.
 */
declare module "*.css";
