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

// Обробники методів
 
// GET: з кешу, а якщо там немає — з http.cat
async function handleGet(res, code) {
  const filePath = cachePath(code);
 
  // Пробуємо віддати з кешу
  try {
    const image = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', [SOURCE_HEADER]: 'cache' });
    res.end(image);
    return;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // інші помилки диска -> 500
  }
 
  // У кеші немає — йдемо на http.cat
  let image;
  try {
    image = await fetchFromHttpCat(code);
  } catch (err) {
    const reason = err.status
      ? `http.cat відповів кодом ${err.status}`
      : `помилка запиту до http.cat: ${err.message}`;
    sendText(res, 404, `Картинку для коду ${code} не знайдено (${reason})`);
    return; // у кеш нічого не зберігаємо
  }
 
  if (!Buffer.isBuffer(image) || image.length === 0) {
    sendText(res, 404, `Картинку для коду ${code} не знайдено (порожня відповідь http.cat)`);
    return;
  }
 
  // Спочатку зберігаємо в кеш, потім надсилаємо клієнтові
  await saveToCache(filePath, image);
  res.writeHead(200, { 'Content-Type': 'image/jpeg', [SOURCE_HEADER]: 'http.cat' });
  res.end(image);
}
 
// PUT: записує картинку з тіла запиту в кеш (або замінює наявну)
async function handlePut(req, res, code) {
  const body = await readBody(req);
  if (body.length === 0) {
    sendText(res, 400, 'Тіло запиту порожнє: передайте картинку');
    return;
  }
  await saveToCache(cachePath(code), body);
  sendText(res, 201, `Картинку для коду ${code} збережено в кеш`);
}
 
// DELETE: видаляє картинку з кешу
async function handleDelete(res, code) {
  try {
    await unlink(cachePath(code));
  } catch (err) {
    if (err.code === 'ENOENT') {
      sendText(res, 404, `Картинки для коду ${code} немає в кеші`);
      return;
    }
    throw err; // інші помилки -> 500
  }
  sendText(res, 200, `Картинку для коду ${code} видалено з кешу`);
}

// HTTP-сервер
const server = http.createServer(async (req, res) => {
  console.log(`${new Date().toISOString()}  ${req.method} ${req.url}`);
  try {
    if (!ALLOWED_METHODS.includes(req.method)) {
      sendText(res, 405, `Метод ${req.method} не підтримується`, {
        Allow: ALLOWED_METHODS.join(', '),
      });
      return;
    }
 
    const code = getStatusCode(req.url);
    if (code === null) {
      sendText(res, 400, 'Некоректний шлях: очікується /<тризначний код>, наприклад /404');
      return;
    }
 
    switch (req.method) {
      case 'GET':
        await handleGet(res, code);
        break;
      case 'PUT':
        await handlePut(req, res, code);
        break;
      case 'DELETE':
        await handleDelete(res, code);
        break;
    }
  } catch (err) {
    // Будь-яка непередбачена помилка -> 500, сервер працює далі
    console.error(err);
    if (!res.headersSent) {
      sendText(res, 500, 'Внутрішня помилка сервера');
    } else {
      res.end();
    }
  }
});

server.listen(port, host);
try {
  await once(server, 'listening');
  console.log(`Сервер працює: http://${host}:${port}`);
  console.log(`Тека кешу: ${cacheDir}`);
} catch (err) {
  console.error(`Не вдалося запустити сервер: ${err.message}`);
  process.exit(1);
}