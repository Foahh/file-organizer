import { copyFile, mkdir } from "node:fs/promises";

await mkdir("./dist", { recursive: true });

await Bun.build({
  entrypoints: ["./src/index.ts"],
  minify: true,
  sourcemap: "linked",
  env: "inline",
  compile: {
    outfile: "./dist/fortify",
  },
});

await copyFile("./rules.toml", "./dist/rules.toml");
console.log("Built ./dist/fortify");
