import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, rename, unlink, rm } from 'node:fs/promises';
import { Command } from 'commander';
import superagent from 'superagent';
 
// Параметри командного рядка
 
const program = new Command();
 
program
  .name('caching-proxy')
  .description('Кешуючий проксі-сервер для картинок з https://http.cat')
  // -h зайнято опцією --host, тому довідку переносимо на -H
  .helpOption('-H, --help', 'показати довідку')
  .requiredOption('-h, --host <address>', 'адреса, на якій працює сервер')
  .requiredOption('-p, --port <number>', 'порт сервера')
  .requiredOption('-c, --cache <path>', 'шлях до теки з кешованими картинками');
 
program.parse();
const options = program.opts();
 
const host = options.host;
const port = Number(options.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  // program.error() виводить повідомлення і завершує процес з кодом 1
  program.error(`error: некоректний порт '${options.port}' (очікується ціле число від 1 до 65535)`);
}
const cacheDir = path.resolve(options.cache);
 
// Тека кешу створюється ДО початку приймання запитів.
// recursive: true — не кидає помилку, якщо тека вже існує.
await mkdir(cacheDir, { recursive: true });