const providers = new Map();

export function define(name, fn) {
  providers.set(name, fn);
}

export async function resolve(env, doInstance, names) {
  const results = [];
  for (const name of names) {
    const fn = providers.get(name);
    if (!fn) continue;
    try {
      const text = await fn(env, doInstance);
      if (text) results.push(text);
    } catch (err) {
      console.error(`[ERROR] context:${name} ${err.message}`);
    }
  }
  return results;
}

export function list() {
  return [...providers.keys()].map(name => ({ name }));
}

define("kanban-rundown", async (env, doInstance) => {
  const key = env.KANBANFLOW_API_KEY;
  if (!key) return "";
  const { response } = await doInstance.generateKanbanRundown(key);
  return `## Kanban Rundown\n${response}`;
});

define("kanban-tasks", async (env, doInstance) => {
  const key = env.KANBANFLOW_API_KEY;
  if (!key) return "";
  const { tasks } = await doInstance.getKanbanTasks(key);
  return `## Current Kanban Tasks\n${tasks}`;
});
