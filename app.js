const authPanel = document.querySelector("#auth-panel");
const appPanel = document.querySelector("#app-panel");
const statusBanner = document.querySelector("#status-banner");
const authForm = document.querySelector("#auth-form");
const logoutButton = document.querySelector("#logout-button");
const userPill = document.querySelector("#user-pill");
const boardElement = document.querySelector("#board");
const boardMetaElement = document.querySelector("#board-meta");
const columnForm = document.querySelector("#column-form");
const columnTitleInput = document.querySelector("#column-title");
const columnTemplate = document.querySelector("#column-template");
const cardTemplate = document.querySelector("#card-template");

let currentUser = null;
let boardState = [];
let pollTimer = null;
let draggedCardId = null;
let sourceColumnId = null;

authForm.addEventListener("submit", handleLogin);
logoutButton.addEventListener("click", handleLogout);
columnForm.addEventListener("submit", handleCreateColumn);

await bootstrap();

async function bootstrap() {
  const session = await api("/api/session");
  currentUser = session.user;
  renderSession();

  if (currentUser) {
    await loadBoard();
    startPolling();
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const formData = new FormData(authForm);
  const login = String(formData.get("login") || "").trim();
  const password = String(formData.get("password") || "");

  try {
    const response = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ login, password }),
    });

    currentUser = response.user;
    authForm.reset();
    renderSession();
    await loadBoard();
    startPolling();
    setStatus("Вход выполнен.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function handleLogout() {
  try {
    await api("/api/logout", { method: "POST" });
    currentUser = null;
    boardState = [];
    renderSession();
    renderBoard();
    stopPolling();
    setStatus("Вы вышли из аккаунта.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function renderSession() {
  if (currentUser) {
    authPanel.classList.add("hidden");
    appPanel.classList.remove("hidden");
    userPill.classList.remove("hidden");
    logoutButton.classList.remove("hidden");
    userPill.textContent = `${currentUser.name} (${currentUser.login})`;
    return;
  }

  authPanel.classList.remove("hidden");
  appPanel.classList.add("hidden");
  userPill.classList.add("hidden");
  logoutButton.classList.add("hidden");
}

async function loadBoard(silent = false) {
  try {
    const response = await api("/api/board");
    boardState = response.columns;
    boardMetaElement.textContent = `${boardState.length} ${pluralize(boardState.length, "колонка", "колонки", "колонок")} в общей доске`;
    renderBoard();
  } catch (error) {
    if (!silent) {
      setStatus(error.message, "error");
    }
  }
}

function renderBoard() {
  boardElement.textContent = "";

  boardState.forEach((column) => {
    const columnNode = columnTemplate.content.firstElementChild.cloneNode(true);
    columnNode.dataset.columnId = String(column.id);

    const titleNode = columnNode.querySelector(".column-title");
    const countNode = columnNode.querySelector(".column-count");
    const cardsNode = columnNode.querySelector(".cards");
    const deleteColumnButton = columnNode.querySelector(".delete-column");
    const cardForm = columnNode.querySelector(".card-form");

    titleNode.textContent = column.title;
    countNode.textContent = `${column.cards.length} ${pluralize(column.cards.length, "карточка", "карточки", "карточек")}`;

    deleteColumnButton.addEventListener("click", async () => {
      try {
        await api(`/api/columns/${column.id}`, { method: "DELETE" });
        await loadBoard(true);
      } catch (error) {
        setStatus(error.message, "error");
      }
    });

    cardForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(cardForm);
      const title = String(formData.get("title") || "").trim();
      const description = String(formData.get("description") || "").trim();

      if (!title) {
        return;
      }

      try {
        await api("/api/cards", {
          method: "POST",
          body: JSON.stringify({
            columnId: column.id,
            title,
            description,
          }),
        });
        cardForm.reset();
        await loadBoard(true);
      } catch (error) {
        setStatus(error.message, "error");
      }
    });

    wireColumnDnD(columnNode, column.id);

    column.cards.forEach((card) => {
      const cardNode = cardTemplate.content.firstElementChild.cloneNode(true);
      cardNode.dataset.cardId = String(card.id);
      cardNode.querySelector(".card-title").textContent = card.title;
      cardNode.querySelector(".card-description").textContent = card.description || "Без описания";

      const deleteCardButton = cardNode.querySelector(".delete-card");
      deleteCardButton.addEventListener("click", async () => {
        try {
          await api(`/api/cards/${card.id}`, { method: "DELETE" });
          await loadBoard(true);
        } catch (error) {
          setStatus(error.message, "error");
        }
      });

      wireCardDnD(cardNode, column.id, card.id);
      cardsNode.appendChild(cardNode);
    });

    boardElement.appendChild(columnNode);
  });
}

async function handleCreateColumn(event) {
  event.preventDefault();
  const title = columnTitleInput.value.trim();

  if (!title) {
    return;
  }

  try {
    await api("/api/columns", {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    columnTitleInput.value = "";
    await loadBoard(true);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function wireCardDnD(cardNode, columnId, cardId) {
  cardNode.addEventListener("dragstart", () => {
    draggedCardId = cardId;
    sourceColumnId = columnId;
    cardNode.classList.add("dragging");
  });

  cardNode.addEventListener("dragend", () => {
    draggedCardId = null;
    sourceColumnId = null;
    cardNode.classList.remove("dragging");
    document.querySelectorAll(".column").forEach((columnNode) => {
      columnNode.classList.remove("drag-over");
    });
  });
}

function wireColumnDnD(columnNode, targetColumnId) {
  const cardsNode = columnNode.querySelector(".cards");

  columnNode.addEventListener("dragover", (event) => {
    event.preventDefault();
    columnNode.classList.add("drag-over");
  });

  columnNode.addEventListener("dragleave", (event) => {
    if (!columnNode.contains(event.relatedTarget)) {
      columnNode.classList.remove("drag-over");
    }
  });

  cardsNode.addEventListener("drop", async (event) => {
    event.preventDefault();
    columnNode.classList.remove("drag-over");

    if (!draggedCardId || !sourceColumnId || sourceColumnId === targetColumnId) {
      return;
    }

    try {
      await api(`/api/cards/${draggedCardId}`, {
        method: "PATCH",
        body: JSON.stringify({ columnId: targetColumnId }),
      });
      await loadBoard(true);
    } catch (error) {
      setStatus(error.message, "error");
    }
  });
}

function startPolling() {
  stopPolling();
  pollTimer = window.setInterval(() => {
    if (currentUser) {
      loadBoard(true);
    }
  }, 2000);
}

function stopPolling() {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
    ...options,
  });

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json() : null;

  if (!response.ok) {
    throw new Error(payload?.error || "Запрос не выполнен");
  }

  return payload;
}

function setStatus(message, type = "success") {
  statusBanner.textContent = message;
  statusBanner.classList.remove("hidden", "error");
  if (type === "error") {
    statusBanner.classList.add("error");
  }
}

function pluralize(count, one, few, many) {
  if (count % 10 === 1 && count % 100 !== 11) {
    return one;
  }

  if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) {
    return few;
  }

  return many;
}
