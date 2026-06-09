// Worker stand-in for SvelteKit's `$env/dynamic/private`, which is a build-time
// virtual module the app server provides but the plain-Node worker does not.
// On the server that module is just the runtime environment, so process.env is
// the faithful equivalent. The resolve hook (loader.js) maps the import here.
export const env = process.env;
