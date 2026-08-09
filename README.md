# FarmConnect 🌾

FarmConnect is a mobile-first Progressive Web App that connects local **farmers** with **consumers**. Consumers broadcast a product request to every nearby farmer (within a 3 km radius); farmers respond, and the best match becomes an order.

The app is a **static, client-side single-page application** — plain HTML/CSS/JavaScript with no build step and no backend server. All state (users, products, orders, notifications) is persisted in the browser's `localStorage` via [`js/store.js`](js/store.js), and the app ships pre-seeded with sample farmer/product data from [`data/farmers.data.js`](data/farmers.data.js).

## Tech stack

- Vanilla HTML/CSS/JS, no framework or bundler
- `localStorage` as the data layer (no database, no REST API)
- Custom hash-free router built on the browser History API ([`js/nav.js`](js/nav.js))
- Served in production by **nginx** (Alpine) inside a Docker container

## Project structure

```
index.html                 App shell (header, bottom nav, view containers)
css/
  main.css                 Base styles, layout, theme
  components.css           Reusable component styles (cards, modals, toasts...)
js/
  app.js                   Entry point / bootstrap / router glue
  auth.js                  Login / registration logic
  store.js                 localStorage data layer (users, products, orders, notifications)
  matching.js              Farmer <-> consumer request matching/broadcast logic
  geo.js                   Distance/geolocation helpers
  notifications.js         Notification creation + badge logic
  nav.js                   Browser History API router (SPA view states)
  agent.js                 Assistant/automation logic
  components/
    modal.js, navbar.js, toast.js
  views/
    auth.view.js            Login/registration screen
    consumer.view.js         Consumer home, request form, match results, order confirmation
    farmer.view.js            Farmer inventory, push offer, add/edit product, requests
    orders.view.js            Order list + order detail
    notifications.view.js     Notifications list
data/
  farmers.data.js           Seed data for demo farmers/products
Dockerfile                  Production image (nginx, Cloud Run ready)
nginx.conf.template         nginx config, rendered at container start with $PORT
docker-compose.yml          Local container run (fixed port 8080)
```

## App views ("endpoints")

There is no server-side API — the app is 100% client rendered. The table below lists every navigable **view state** the router ([`js/nav.js`](js/nav.js)) understands; these are the closest equivalent to "endpoints" in this app. Each is pushed to `history.state` as `{ view: '<name>', ... }` so the browser back/forward buttons work natively.

| View state         | Renders                                             | Source |
|---------------------|------------------------------------------------------|--------|
| *(unauthenticated)* | Login / registration                                  | [`js/views/auth.view.js`](js/views/auth.view.js) |
| `consumer-home`     | Consumer home / product search                        | [`js/views/consumer.view.js`](js/views/consumer.view.js) `showHome()` |
| `request-form`      | Create a product request                               | `showRequestForm()` |
| `match-results`      | Farmers matched to a broadcast request                 | `showMatchResults()` |
| `order-confirm`      | Confirm an order with a chosen farmer                   | `showOrderConfirmation()` |
| `farmer-inventory`   | Farmer's product inventory (home for farmer role)        | [`js/views/farmer.view.js`](js/views/farmer.view.js) `showInventory()` |
| `farmer-push`        | Push a product offer to nearby consumers                | `showPushForm()` |
| `farmer-add`          | Add a new product                                       | `showAddProduct()` |
| `farmer-edit`         | Edit an existing product                                | `showEditProduct(productId)` |
| `farmer-requests`     | Incoming consumer requests                               | `showRequests()` |
| `orders`              | Order list (both roles)                                  | [`js/views/orders.view.js`](js/views/orders.view.js) `show()` |
| `order-detail`         | Single order detail                                      | `showDetail(orderId)` |
| `notifications`        | Notification center                                       | [`js/views/notifications.view.js`](js/views/notifications.view.js) `show()` |

All data reads/writes behind these views go through [`js/store.js`](js/store.js) (`Store.getUsers`, `Store.addOrder`, `Store.getAllFarmers`, etc.) and are scoped to the visiting browser's `localStorage` — nothing is sent to a server.

## Running locally (no Docker)

Any static file server works, since the app has no build step:

```bash
npx serve .
```

or with Python:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`.

## Running with Docker

```bash
docker build -t farmconnect .
docker run -p 8080:8080 farmconnect
```

Open `http://localhost:8080`.

Or with docker-compose:

```bash
docker compose up --build
```

## Deploying to Google Cloud Run

The image listens on the port given by the `PORT` environment variable (defaults to `8080`), which is exactly what Cloud Run requires — nginx's config is rendered from [`nginx.conf.template`](nginx.conf.template) at container startup via `envsubst`, so no manual port configuration is needed.

### 1. One-time setup

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com
```

### 2. Build and push the image

Using Cloud Build (recommended — no local Docker required):

```bash
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/farmconnect
```

Or build locally and push:

```bash
docker build -t gcr.io/YOUR_PROJECT_ID/farmconnect .
docker push gcr.io/YOUR_PROJECT_ID/farmconnect
```

### 3. Deploy to Cloud Run

```bash
gcloud run deploy farmconnect \
  --image gcr.io/YOUR_PROJECT_ID/farmconnect \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --port 8080
```

`gcloud` prints the live service URL once the deploy finishes.

### Updating a deployed service

Re-run steps 2–3 — `gcloud run deploy` creates a new revision and shifts traffic automatically.

### Notes

- The app persists all data in each visitor's browser `localStorage`; nothing is stored server-side, so Cloud Run's stateless/autoscaling instances (including scale-to-zero) don't affect app data or require a database.
- Static assets (`js`, `css`, images) are served with a 30-day cache header; `index.html` and all unknown paths fall back to `index.html` so the client-side router handles deep links correctly.
