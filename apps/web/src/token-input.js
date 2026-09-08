let tokenInputSequence = 0;

function normalize(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function createTokenInput(root, options = {}) {
  const input = root.querySelector("[data-token-entry]");
  const hidden = root.querySelector("[data-token-value]");
  const list = root.querySelector("[data-token-list]");
  const error = root.parentElement.querySelector("[data-token-error]");
  const datalist = document.createElement("datalist");
  datalist.id = `token-options-${++tokenInputSequence}`;
  root.append(datalist);
  input.setAttribute("list", datalist.id);

  let choices = [];
  let values = [];

  function choiceFor(raw) {
    const candidate = normalize(raw).replace(/\s+[—-]\s+.*$/, "");
    const exact = choices.find(
      (choice) =>
        normalize(choice.id) === candidate ||
        normalize(choice.name) === candidate ||
        (choice.aliases ?? []).some((alias) => normalize(alias) === candidate)
    );
    if (exact) return exact;
    const partial = choices.filter(
      (choice) =>
        normalize(choice.name).includes(candidate) ||
        (choice.aliases ?? []).some((alias) => normalize(alias).includes(candidate))
    );
    return partial.length === 1 ? partial[0] : undefined;
  }

  function displayName(value) {
    return choices.find((choice) => choice.id === value)?.name ?? value;
  }

  function sync() {
    hidden.value = values.join(",");
    list.replaceChildren(
      ...values.map((value) => {
        const chip = document.createElement("span");
        chip.className = "token-chip";
        const text = document.createElement("span");
        text.textContent = `${value} · ${displayName(value)}`;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.dataset.removeToken = value;
        remove.setAttribute("aria-label", `Remove ${value}`);
        remove.textContent = "×";
        chip.append(text, remove);
        return chip;
      })
    );
    root.classList.toggle("has-tokens", values.length > 0);
    root.dispatchEvent(new CustomEvent("tokenschange", { detail: { values: [...values] } }));
  }

  function setError(message = "") {
    if (error) error.textContent = message;
    root.classList.toggle("invalid", Boolean(message));
  }

  function commit() {
    const raw = input.value.trim();
    if (!raw) return true;
    const choice = choiceFor(raw);
    let value = choice?.id;
    if (!value && options.allowCustomPattern?.test(raw)) value = raw.toUpperCase();
    if (!value) {
      setError(options.invalidMessage ?? "Choose an item from the suggestions.");
      return false;
    }
    if (!values.includes(value)) values.push(value);
    input.value = "";
    setError();
    sync();
    return true;
  }

  function setOptions(nextChoices = []) {
    choices = nextChoices.map((choice) => ({ ...choice, id: String(choice.id) }));
    datalist.replaceChildren(
      ...choices.map((choice) => {
        const option = document.createElement("option");
        option.value = `${choice.id} — ${choice.name}`;
        return option;
      })
    );
    sync();
  }

  function setValues(nextValues = []) {
    values = [...new Set(nextValues.map((value) => String(value).trim()).filter(Boolean))];
    input.value = "";
    setError();
    sync();
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit();
    }
    if (event.key === "Backspace" && !input.value && values.length) {
      values.pop();
      sync();
    }
  });
  input.addEventListener("change", commit);
  input.addEventListener("input", () => setError());
  input.addEventListener("blur", () => {
    if (input.value.trim()) commit();
  });
  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-token]");
    if (!button) return;
    values = values.filter((value) => value !== button.dataset.removeToken);
    sync();
    input.focus();
  });

  setOptions(options.choices);
  return { commit, getValues: () => [...values], setOptions, setValues };
}
