// Relay Todo — vanilla JS, no build step.
const todos = [];

const form = document.getElementById("add-form");
const input = document.getElementById("add-input");
const list = document.getElementById("todo-list");
const stats = document.getElementById("stats");

function render() {
  list.innerHTML = "";
  todos.forEach((todo, i) => {
    const li = document.createElement("li");
    li.textContent = todo.text;
    li.className = todo.done ? "done" : "";
    li.addEventListener("click", () => {
      todo.done = !todo.done;
      render();
    });
    list.appendChild(li);
  });
  const done = todos.filter((t) => t.done).length;
  stats.textContent = todos.length
    ? `共 ${todos.length} 项,完成 ${done} 项`
    : "还没有任务,加一个吧";
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  todos.push({ text, done: false });
  input.value = "";
  render();
});

render();
