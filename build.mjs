import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("./", import.meta.url);
const generatedDir = new URL("./src/generated/", root);
await mkdir(generatedDir, { recursive: true });

const [xtermCss, xtermJs, fitJs] = await Promise.all([
  readFile(new URL("./node_modules/@xterm/xterm/css/xterm.css", root), "utf8"),
  readFile(new URL("./node_modules/@xterm/xterm/lib/xterm.js", root), "utf8"),
  readFile(new URL("./node_modules/@xterm/addon-fit/lib/addon-fit.js", root), "utf8"),
]);

async function optionalBackground(name) {
  const candidates = [
    [`${name}.png`, "image/png"],
    [`${name}.jpg`, "image/jpeg"],
    [`${name}.jpeg`, "image/jpeg"],
    [`${name}.webp`, "image/webp"],
    [`${name}.gif`, "image/gif"],
  ];

  for (const [file, mime] of candidates) {
    try {
      const data = await readFile(new URL(`./image/${file}`, root));
      return `data:${mime};base64,${data.toString("base64")}`;
    } catch {
      // Try next extension.
    }
  }
  return "";
}

const [desktopBackground, mobileBackground] = await Promise.all([
  optionalBackground("desktop"),
  optionalBackground("mobile"),
]);

await writeFile(
  new URL("./vendor-assets.ts", generatedDir),
  [
    `export const XTERM_CSS = ${JSON.stringify(xtermCss)};`,
    `export const XTERM_JS = ${JSON.stringify(xtermJs)};`,
    `export const FIT_JS = ${JSON.stringify(fitJs)};`,
    `export const DESKTOP_BACKGROUND = ${JSON.stringify(desktopBackground)};`,
    `export const MOBILE_BACKGROUND = ${JSON.stringify(mobileBackground)};`,
    "",
  ].join("\n"),
);

await build({
  entryPoints: ["src/worker.ts"],
  outfile: "dist/worker.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  external: ["cloudflare:sockets"],
  plugins: [
    {
      name: "workers-native-stubs",
      setup(build) {
        build.onResolve({ filter: /^cpu-features$/ }, () => ({
          path: "cpu-features",
          namespace: "native-stub",
        }));
        build.onResolve({ filter: /\.node$/ }, () => ({
          path: "native-binding",
          namespace: "native-stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "native-stub" }, (args) => {
          if (args.path === "cpu-features") {
            return {
              contents: "module.exports = function cpuFeatures() { return undefined; };",
              loader: "js",
            };
          }
          return {
            contents: "module.exports = null;",
            loader: "js",
          };
        });
      },
    },
  ],
  define: {
    __dirname: '"/"',
    __filename: '"/worker.js"',
  },
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire("/worker.js");',
  },
});
