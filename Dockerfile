FROM nginx:1.25-alpine

# Remove default nginx static assets
RUN rm -rf /usr/share/nginx/html/*

# Custom nginx config template — rendered at container start with the
# PORT env var so the image works both locally (docker-compose) and on
# Cloud Run, which injects a dynamic PORT (defaults to 8080 here).
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
ENV PORT=8080

# Copy application static files only (avoids leaking Dockerfile/configs
# into the served directory regardless of .dockerignore correctness)
COPY index.html /usr/share/nginx/html/index.html
COPY css/       /usr/share/nginx/html/css/
COPY js/        /usr/share/nginx/html/js/
COPY data/      /usr/share/nginx/html/data/

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
