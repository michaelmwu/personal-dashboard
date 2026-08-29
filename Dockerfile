FROM oven/bun:1.3.14

WORKDIR /app

ENV NODE_ENV=production \
    API_HOST=127.0.0.1 \
    API_PORT=8810 \
    WEB_HOST=0.0.0.0 \
    WEB_PORT=8811 \
    PERSONAL_DASHBOARD_API_BASE_URL=http://127.0.0.1:8810 \
    DASHBOARD_DATA_FILE=/data/dashboard-store.json \
    CODING_AGENT_RUN_EVIDENCE_DIR=/data/runs \
    HOME=/data/home

COPY . ./
RUN bun install --frozen-lockfile --ignore-scripts --production --minimum-release-age=604800 \
    && install --directory --owner=bun --group=bun --mode=0700 /data /data/home /data/runs

COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

EXPOSE 8811
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:8811/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "scripts/production.mjs"]
