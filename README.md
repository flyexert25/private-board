# Private Board

Закрытая веб-доска для двух пользователей без внешних сервисов.

## Features

- Python-сервер без сторонних зависимостей
- SQLite для колонок и карточек
- два локальных аккаунта
- `HttpOnly` cookie-сессии
- общая доска для двух пользователей
- синхронизация через polling

## Run

```powershell
python server.py
```

Откройте:

- `http://127.0.0.1:8000`

Если второй пользователь заходит из той же локальной сети:

- `http://YOUR_LOCAL_IP:8000`

## Initial Accounts

При первом запуске создаются два аккаунта:

- `owner` / `change-me-owner`
- `friend` / `change-me-friend`

Сразу после запуска лучше сменить пароли:

```powershell
python server.py --set-password owner my-new-password
python server.py --set-password friend my-other-password
```

## Security Notes

- пароли хранятся только как PBKDF2-хэши
- без входа API недоступен
- cookie помечены как `HttpOnly` и `SameSite=Lax`
- локальная база и пользователи исключены из Git через `.gitignore`

## Project Structure

- `server.py` — backend и API
- `index.html` — интерфейс
- `app.js` — логика клиента
- `styles.css` — стили
