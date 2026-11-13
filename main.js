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


// Допоміжні функції
 
const ALLOWED_METHODS = ['GET', 'PUT', 'DELETE'];
const SOURCE_HEADER = 'X-Image-Source'; // звідки взято картинку: cache або http.cat
 
// Текстова відповідь (для помилок і підтверджень)
function sendText(res, statusCode, message, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    ...extraHeaders,
  });
  res.end(message);
}
 
function getStatusCode(url) {
  const { pathname } = new URL(url, 'http://localhost');
  const match = /^\/(\d{3})$/.exec(pathname);
  return match ? match[1] : null;
}
 
// Шлях до файлу картинки в кеші: <cache>/404.jpg
function cachePath(code) {
  return path.join(cacheDir, `${code}.jpg`);
}
 
// Читає все тіло запиту. req — це потік (Readable stream),
// дані надходять частинами; for await збирає їх без колбеків.
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
 
async function saveToCache(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(tmpPath, data);
    await rename(tmpPath, filePath);
  } catch (err) {
    await rm(tmpPath, { force: true }); // прибираємо тимчасовий файл
    throw err;
  }
}
 
// Запит картинки до http.cat через superagent.
// Проміс відхиляється, якщо http.cat повернув 4xx/5xx або сталася мережева помилка.
async function fetchFromHttpCat(code) {
  const response = await superagent
    .get(`https://http.cat/${code}`)
    .responseType('blob') // тіло відповіді — Buffer (двійкові дані без змін)
    .timeout({ response: 5000, deadline: 15000 });
  return response.body;
}