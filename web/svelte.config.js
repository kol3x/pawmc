import { vitePreprocess } from "@sveltejs/vite-plugin-svelte"

/** Svelte compilation settings shared by the Vite plugin and svelte-check. */
export default {
	preprocess: vitePreprocess(),
}
