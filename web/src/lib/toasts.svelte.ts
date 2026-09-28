export type ToastKind = "info" | "success" | "error"

export interface Toast {
	id: number
	msg: string
	kind: ToastKind
}

/** Global toast queue rendered by ToastHost. */
class ToastState {
	list = $state<Toast[]>([])
}

export const toasts = new ToastState()

let nextId = 1

/**
 * Queues a toast shown for ~3.5s.
 */
export function pushToast(msg: string, kind: ToastKind = "info"): void {
	const id = nextId++
	toasts.list = [...toasts.list, { id, msg, kind }]
	window.setTimeout(() => dismissToast(id), 3500)
}

/**
 * Removes a toast by id.
 */
export function dismissToast(id: number): void {
	toasts.list = toasts.list.filter((t) => t.id !== id)
}
