FROM denoland/deno:2.4.2

WORKDIR /app

COPY deno.json deno.lock ./
RUN deno install

COPY . .
RUN deno check main.ts

EXPOSE 8080

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-sys=osRelease,hostname", "main.ts"]
