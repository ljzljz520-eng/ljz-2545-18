'use strict';

const { Store } = require('./store');
const { ChapterService } = require('./chapterService');
const { NeighborhoodService } = require('./neighborhoodService');
const { RouteService } = require('./routeService');
const { ResponseGuard, TreeCache } = require('./cache');

// 服务门面：网页层 / HTTP 适配层只依赖这一个入口
function createServices(store = new Store()) {
  return {
    store,
    chapters: new ChapterService(store),
    neighborhoods: new NeighborhoodService(store),
    routes: new RouteService(store),
    guard: new ResponseGuard(),
    treeCache: new TreeCache(),
  };
}

module.exports = { createServices, Store };
