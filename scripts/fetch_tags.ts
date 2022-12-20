import cheerio from "cheerio";
import numeral = require("numeral");
import * as path from "path";
import * as fs from "fs";

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const debug = require("debug")("fetch");

const url = "https://nhentai.net/";

let browserWSEndpoint: any;

type Tag = {
  id: number;
  name: string;
  count: number;
};

type Category = "tags" | "artists" | "characters" | "parodies" | "groups";

type ParsedResult<T extends Category> = {
  category: T;
  page: number;
  last: number;
  tags: Tag[];
};

function parse(category: Category, html: string): ParsedResult<Category> {
  const $ = cheerio.load(html);
  const tags = $("div#tag-container a.tag")
    .map((_, tag) => {
      const id = $(tag).attr("class")!.split(" ")[1].replace("tag-", "");
      const name = $("span.name", tag).text();
      const count = $("span.count", tag).text().toLowerCase();
      return <Tag>{
        id: parseInt(id),
        name,
        count: numeral(count).value(),
      };
    })
    .get();
  const pagination = $("section.pagination");
  const page = $("a.page.current", pagination).text();
  const lastEl = $("a.last", pagination).first();
  const last = lastEl.length > 0 ? lastEl.attr("href")!.split("=", 2)[1] : page;
  return {
    category,
    page: parseInt(page),
    last: parseInt(last),
    tags,
  };
}

async function init() {
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      "--window-size=640,480",
      // "--disable-infobars",
      // "--disable-gpu",
      // "--disable-dev-shm-usage",
      // "--disable-setuid-sandbox",
      "--no-first-run",
      // "--no-sandbox",
      // "--no-zygote",
      // "--single-process",
    ],
  });
  browserWSEndpoint = await browser.wsEndpoint();
  const page = await browser.newPage();
  await page.setDefaultNavigationTimeout(0); // 禁用超时
  await page.setViewport({
    width: 1280,
    height: 720,
  });
  await page.goto(url);
  await page.waitForSelector(".container.index-container");
  await page.close();
}

async function fetchHtml(category: Category, pageNum = 1): Promise<string> {
  // 复用浏览器
  const browser = await puppeteer.connect({ browserWSEndpoint });
  // const browser = await puppeteer.launch({ headless: false });

  const page = await browser.newPage();

  await page.setDefaultNavigationTimeout(0); // 禁用超时

  // 拦截静态资源 加快速度
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (["image", "stylesheet", "font"].includes(request.resourceType())) {
      return request.abort();
    }
    return request.continue();
  });
  await page.setViewport({
    width: 1280,
    height: 720,
  });
  await page.goto(url + category + "/?page=" + pageNum, {
    waitUntil: "domcontentloaded",
  });

  // log
  debug(":fetchHtml category:", category, "page:", pageNum);

  await page.waitForSelector("#tag-container");
  const html = await page.content();
  await page.close();
  // await browser.close();
  return html;
}

async function fetchAndParse(
  category: Category,
  pageNum = 1
): Promise<ParsedResult<Category>> {
  // log
  debug(":fetchAndParse category:", category, "page:", pageNum);
  const html = await fetchHtml(category, pageNum);
  return parse(category, html);
}

async function fetchAll(
  category: Category
): Promise<{ category: Category; tags: Tag[] }> {
  // debug(":fetchAll category:", category);
  const result: Tag[] = [];

  const pool = 4;
  let lastPage = pool;
  let maxIndex = 1;

  for (let index = 0; index <= maxIndex; index++) {
    const resPromiseList = [];
    const unproc = lastPage - index * pool;
    const proc = unproc > pool ? pool : unproc;

    debug(":fetchAll index:", index, "proc:", proc);
    for (let i = 1; i <= proc; i++) {
      resPromiseList.push(fetchAndParse(category, index * pool + i));
    }
    const resList = await Promise.all(resPromiseList);

    for (let i = 0; i < resList.length; i++) {
      const res = resList[i];
      result.push(...res.tags);
      if (index == 0) {
        lastPage = res.last;
        maxIndex = Math.ceil(lastPage / pool);
      }
    }

    // 一定次数循环后 重新创建一个浏览器
    if (index > 0 && index % 10 === 0) {
      const browser = await puppeteer.connect({ browserWSEndpoint });
      await browser.close();
      await init();
    }
  }

  return {
    category,
    tags: result,
  };
}

async function fetchAllQ(
  category: Category
): Promise<{ category: Category; tags: Tag[] }> {
  debug(":fetchAll category:", category);
  const result: Tag[] = [];
  let page = 1;
  let last = 1;

  do {
    debug(":fetchAll page:", page);
    const res = await fetchAndParse(category, page++);

    result.push(...res.tags);
    last = res.last;
  } while (page <= last);

  return {
    category,
    tags: result,
  };
}

const Categories: Category[] = [
  "tags",
  "artists",
  "characters",
  "parodies",
  "groups",
];

const assetsDir = path.resolve(__dirname, "..", "assets");
fs.existsSync(assetsDir) || fs.mkdirSync(assetsDir);
(async () => {
  await init();
  for (let category of Categories) {
    const { tags } = await fetchAll(category);
    fs.writeFileSync(
      path.resolve(assetsDir, `${category}.json`),
      JSON.stringify(tags)
    );
  }
  const browser = await puppeteer.connect({ browserWSEndpoint });
  await browser.close();
})().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
