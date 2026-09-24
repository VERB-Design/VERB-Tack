export async function resolve(specifier, context, next) {
  if (specifier === "@netlify/blobs") {
    return { url: new URL("./mock-blobs.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
