# Bliss Fox Studio static website container
# Coolify can build this repo directly from GitHub using Dockerfile mode.
FROM nginx:1.27-alpine

# Remove default nginx page
RUN rm -rf /usr/share/nginx/html/*

# Custom nginx config for static site hosting + health checks
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Website files. Explicit chmod matters because local generated files may be mode 600.
COPY *.html /usr/share/nginx/html/
RUN chmod -R a+rX /usr/share/nginx/html

# Lightweight healthcheck that Coolify/Docker can use
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
