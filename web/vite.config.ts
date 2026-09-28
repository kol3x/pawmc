import { defineConfig } from "vite"
import { svelte } from "@sveltejs/vite-plugin-svelte"
import tailwindcss from "@tailwindcss/vite"

/**
 * Vite config for the pawmc SPA. In dev, API routes are proxied to `wrangler dev`
 * on localhost:8787 so the UI talks to the real worker; in prod, `vite build`
 * emits static assets consumed by the worker's ASSETS binding (web/dist).
 */
export default defineConfig({
	plugins: [tailwindcss(), svelte()],
	server: {
		proxy: {
			"/chat": "http://localhost:8787",
			"/categories": "http://localhost:8787",
			"/conversations": "http://localhost:8787",
			"/conversation": "http://localhost:8787",
			"/update-summaries": "http://localhost:8787",
			"/update-summary": "http://localhost:8787",
			"/rename-category": "http://localhost:8787",
			"/rename-topic": "http://localhost:8787",
			"/update-message": "http://localhost:8787",
			"/category": "http://localhost:8787",
			"/topic": "http://localhost:8787",
			"/message": "http://localhost:8787",
		},
	},
})
