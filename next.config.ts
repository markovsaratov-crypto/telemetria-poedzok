import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // v2.10.4 (TRUST-1): типы чисты (tsc --noEmit = 0) — блокировщик маски снят.
  // История: флаг ставился в v2.9.x как временный workaround серии Edge-bundle
  // build-failures (v2.9.8–v2.9.10, crypto в Edge); P0-фикс db.ts закрыл причину.
  typescript: { ignoreBuildErrors: false },
  reactStrictMode: false,
  experimental: {
    serverActions: { bodySizeLimit: "100mb" },
    // v2.40.6 (инцидент 20.09 «ошибка импорта»): Next.js 16 клонирует тело
    // запроса через proxy-слой (proxy.ts в Node-runtime) с ДЕФОЛТНЫМ лимитом
    // 10 МБ (DEFAULT_BODY_CLONE_SIZE_LIMIT, body-streams.js). ZIP-архив
    // SensorLogger 45.6 МБ обрезался до 10 МБ → request.formData() падал
    // «Failed to parse body as FormData» → 500 «Import failed» при полностью
    // рабочем роуте импорта (его собственный лимит 100 МБ не при чём).
    // Воспроизведено локально: warning «Request body exceeded 10MB for
    // /api/import/zip. Only the first 10MB will be available unless
    // configured». 150 МБ = MAX_ZIP_BYTES (100 МБ) + запас на multipart-обёртку
    // и метаданные formData. Роуты импорта продолжают контролировать размер сами.
    proxyClientMaxBodySize: "150mb",
  },
};

export default nextConfig;
