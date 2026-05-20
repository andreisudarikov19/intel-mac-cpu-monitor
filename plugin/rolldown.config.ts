import path from "node:path";
import url from "node:url";
import { defineConfig } from "rolldown";

const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "dev.andreisudarikov.intel-mac-monitor";
const sdPluginFolder = `../${sdPlugin}.sdPlugin`;

export default defineConfig({
    input: "src/plugin.ts",
    output: {
        file: `${sdPluginFolder}/bin/plugin.js`,
        sourcemap: isWatching,
        sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
            return url.pathToFileURL(
                path.resolve(path.dirname(sourcemapPath), relativeSourcePath)
            ).href;
        },
        minify: !isWatching,
    },
    transform: {
        decorator: { legacy: true },
    },
    platform: "node",
    resolve: {
        conditionNames: ["node"],
    },
    plugins: [
        {
            name: "emit-module-package-file",
            generateBundle() {
                this.emitFile({
                    fileName: "package.json",
                    source: `{ "type": "module" }`,
                    type: "asset",
                });
            },
        },
    ],
});
