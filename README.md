# Whitney Farm Viewer 2

Static split-shell SOGS viewer for the Whitney Farm bundle.

## Local development

```bash
npm install
npm run dev
```

The Vite dev server serves the repo root, and `/` redirects to `/3d/`.

## Repo structure

- `3d/`: shell app
- `supersplat-viewer/`: renderer app
- `index.html`: root redirect for GitHub Pages and local startup

## Default bundle

The shell defaults to:

`https://spaceport-ml-processing.s3.amazonaws.com/compressed/edited-splat-20260330-browser/supersplat_bundle/meta.json`

This repo is configured to load that public S3 bundle directly, without the old `/api/sogs-proxy` dependency.
