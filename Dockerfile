# One image: the React app built and embedded into a static Go binary.
# Cloud Run builds this on every push to main.

FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY docs/GO-API.ts /docs/GO-API.ts
COPY web/ ./
RUN mkdir -p /server/assets/dist && npm run build

FROM golang:1.24-alpine AS build
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
COPY --from=web /server/assets/dist ./assets/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /mpb ./cmd/mpb

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /mpb /mpb
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/mpb"]
