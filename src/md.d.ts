// `with { type: "file" }` imports of the bundled agent definitions: bun-types declares *.html/*.txt but not *.md.
declare module "*.md" {
  const content: string;
  export = content;
}
