const STORAGE_KEY = "local-task-board-v1";

const defaultBoard = [
  {
    id: crypto.randomUUID(),
    title: "Идеи",
    cards: [
      {
        id: crypto.randomUUID(),
        title: "Продумать приоритеты",
        description: "Собрать список задач на неделю и выделить главное.",
      },
      {
        id: crypto.randomUUID(),
        title: "Подготовить план",
        description: "Разбить крупные задачи на небольшие шаги.",
      },
    ],
  },
  {
    id: crypto.randomUUID(),
    title: "В работе",
    cards: [
      {
        id: crypto.randomUUID(),
        title: "Текущая задача",
        description: "Карточки можно переносить между колонками drag-and-drop.",
      },
    ],
  },
  {
    id: crypto.randomUUID(),
    title: "Готово",
    cards: [
      {
        id: crypto.randomUUID(),
        title: "Настройка доски",
        description: "Прогресс автоматически сохраняется в браузере.",
      },
    ],
  },
];

const statusBanner = document.querySelector("#status-banner");
const boardElement = document.querySelector("#board");
const boardTitleElement = document.querySelector("#board-title");
const boardMetaElement = document.querySelector("#board-meta");
const columnForm = document.querySelector("#column-form");
const columnTitleInput = document.querySelector("#column-title");
const resetBoardButton = document.querySelector("#reset-board");
const columnTemplate = document.querySelector("#column-template");
const cardTemplate = document.querySelector("#card-template");

let boardState = loadBoard();
let draggedCardId = null;
let sourceColumnId = null;

boardTitleElement.textContent = "Моя доска";
columnForm.addEventListener("submit", handleCreateColumn);
resetBoardButton.addEventListener("click", handleResetBoard);

renderBoard();
setStatus("Доска готова. Все изменения сохраняются локально.", "success");

function handleCreateColumn(event) {
  event.preventDefault();
  const title = columnTitleInput.value.trim();

  if (!title) {
    return;
  }

  boardState.push({
    id: crypto.randomUUID(),
    title,
    cards: [],
  });

  persistBoard();
  columnTitleInput.value = "";
  renderBoard();
}

function handleResetBoard() {
  boardState = structuredClone(defaultBoard);
  persistBoard();
  renderBoard();
  setStatus("Доска сброшена к стартовому состоянию.", "success");
}

function loadBoard() {
  const saved = localStorage.getItem(STORAGE_KEY);

  if (!saved) {
    return structuredClone(defaultBoard);
  }

  try {
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) {
      return structuredClone(defaultBoard);
    }
    return parsed;
  } catch {
    return structuredClone(defaultBoard);
  }
}

function persistBoard() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(boardState));
}

function renderBoard() {
  boardElement.textContent = "";
  boardMetaElement.textContent = `${boardState.length} ${pluralize(boardState.length, "колонка", "колонки", "колонок")} в работе`;

  boardState.forEach((column) => {
    const columnNode = columnTemplate.content.firstElementChild.cloneNode(true);
    columnNode.dataset.columnId = column.id;

    const titleNode = columnNode.querySelector(".column-title");
    const countNode = columnNode.querySelector(".column-count");
    const cardsNode = columnNode.querySelector(".cards");
    const deleteColumnButton = columnNode.querySelector(".delete-column");
    const cardForm = columnNode.querySelector(".card-form");

    titleNode.textContent = column.title;
    countNode.textContent = `${column.cards.length} ${pluralize(column.cards.length, "карточка", "карточки", "карточек")}`;

    deleteColumnButton.addEventListener("click", () => {
      boardState = boardState.filter((item) => item.id !== column.id);
      persistBoard();
      renderBoard();
    });

    cardForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormData(cardForm);
      const title = String(formData.get("title") || "").trim();
      const description = String(formData.get("description") || "").trim();

      if (!title) {
        return;
      }

      column.cards.push({
        id: crypto.randomUUID(),
        title,
        description,
      });

      persistBoard();
      cardForm.reset();
      renderBoard();
    });

    wireColumnDnD(columnNode, column.id);

    column.cards.forEach((card) => {
      const cardNode = cardTemplate.content.firstElementChild.cloneNode(true);
      cardNode.dataset.cardId = card.id;
      cardNode.querySelector(".card-title").textContent = card.title;
      cardNode.querySelector(".card-description").textContent = card.description || "Без описания";

      const deleteCardButton = cardNode.querySelector(".delete-card");
      deleteCardButton.addEventListener("click", () => {
        column.cards = column.cards.filter((item) => item.id !== card.id);
        persistBoard();
        renderBoard();
      });

      wireCardDnD(cardNode, column.id, card.id);
      cardsNode.appendChild(cardNode);
    });

    boardElement.appendChild(columnNode);
  });
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

  cardsNode.addEventListener("drop", (event) => {
    event.preventDefault();
    columnNode.classList.remove("drag-over");

    if (!draggedCardId || !sourceColumnId || sourceColumnId === targetColumnId) {
      return;
    }

    moveCard(sourceColumnId, targetColumnId, draggedCardId);
  });
}

function moveCard(fromColumnId, toColumnId, cardId) {
  const fromColumn = boardState.find((column) => column.id === fromColumnId);
  const toColumn = boardState.find((column) => column.id === toColumnId);

  if (!fromColumn || !toColumn) {
    return;
  }

  const cardIndex = fromColumn.cards.findIndex((card) => card.id === cardId);
  if (cardIndex === -1) {
    return;
  }

  const [card] = fromColumn.cards.splice(cardIndex, 1);
  toColumn.cards.push(card);
  persistBoard();
  renderBoard();
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
