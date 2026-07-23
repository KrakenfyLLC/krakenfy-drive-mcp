# Krakenfy Drive MCP

Servidor MCP open source para que agentes de IA trabajen con Google Drive y Google Sheets usando un
proyecto OAuth que controla el propio usuario. No depende de conectores nativos de ChatGPT o Claude.

**[Instalación administrada para equipos →](https://krakenfyllc.github.io/krakenfy-drive-mcp/)**

## Capacidades

- Buscar archivos y navegar carpetas con paginación.
- Leer, exportar y descargar archivos.
- Crear carpetas; subir, copiar, mover y renombrar archivos.
- Enviar elementos a la papelera con confirmación explícita.
- Leer y actualizar rangos acotados de Google Sheets.
- Compatibilidad con unidades compartidas.

## Seguridad

- Las credenciales viven fuera del repositorio.
- Los tokens se guardan con permisos `0600`.
- Las descargas nunca sobrescriben archivos locales.
- Las eliminaciones son recuperables y exigen `confirm: true`.
- Las respuestas textuales se limitan a 2 MiB.
- Cada usuario utiliza su propio proyecto de Google Cloud.

## Instalación

Consulta la [guía de instalación](docs/INSTALL.md). Para una instalación administrada y adaptaciones
empresariales, consulta [servicios](docs/MANAGED-SERVICE.md).

## Desarrollo

```bash
npm ci
npm run check
npm test
```

## Licencia

MIT. Consulta [LICENSE](LICENSE).
