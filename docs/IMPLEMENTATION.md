# WordsBook 实施文档

## 1. 项目定位
WordsBook 是一个可在 iPhone Safari 添加到主屏幕的离线优先背单词应用。

核心功能：
1. 查词：本地词典极速检索，支持精确、词形还原、前缀、模糊匹配。
2. 单词本：将词条加入本地学习库，支持备注/标签维护与删除。
3. 复习：艾宾浩斯节奏（0/1/2/4/7/15/30/60 天）推进周期。
4. 数据能力：支持备份导出、备份导入。

## 2. 技术栈
1. Vue 3 + TypeScript + Vite
2. Pinia（状态管理）
3. Dexie + IndexedDB（持久化）
4. vite-plugin-pwa + Workbox（离线缓存）
5. Vitest / Playwright（测试）

## 3. 目录结构
```text
src/
  app/
    AppShell.vue
    router.ts
  db/
    database.ts
  modules/
    dictionary/
      dictionaryInstaller.ts
      dictionaryService.ts
      dictionaryStore.ts
      audioService.ts
      search.ts
    review/
      scheduler.ts
      reviewService.ts
    settings/
      settingsService.ts
      settingsStore.ts
      backupService.ts
    wordbook/
      wordbookService.ts
  views/
    LookupView.vue
    ReviewView.vue
    WordbookView.vue
    SettingsView.vue
  types/models.ts
  utils/
    debounce.ts
    json.ts
```

## 4. 数据模型（IndexedDB）
1. dictionary_meta: 当前词典版本元信息。
2. dictionary_entries: 词条数据。
3. dictionary_index: 预构建 token -> entryIds 索引。
4. wordbook: 用户加入的学习词。
5. review_state: 每个词当前周期、下次复习时间。
6. review_logs: 每次评分日志。
7. settings: 应用配置（自动发音、每日上限等）。

## 5. 查词链路
1. 输入 250ms 防抖。
2. 检索顺序：精确 -> lemma -> prefix -> fuzzy。
3. 词条展示：词头、音标、词性、释义、例句。
4. 发音：音频优先，失败后 TTS。

## 6. 背词链路
1. buildTodayPlan：到期优先 + 新词补齐。
2. 卡片评分：remember / forget。
3. gradeCard：周期推进或回退，并写 review_logs。

## 7. 词典安装链路
1. 读取 manifest。
2. 下载 entries/indices 分片并可校验。
3. Dexie 事务导入，失败回滚。
4. 更新 dictionary_meta 指向 active 版本。

## 8. 备份恢复
1. 导出：wordbook/review_state/review_logs/settings 到 JSON。
2. 导入：校验 schema 后 bulkPut 回库。

## 9. 运行与发布
```bash
npm install
npm run dev
npm run build
npm run preview
npm run test
```

部署到 Cloudflare Pages / Vercel / Netlify（必须 HTTPS）。

## 10. iPhone 使用步骤
1. Safari 打开站点。
2. 点击分享 -> 添加到主屏幕。
3. 首次安装内置词典。
4. 进入飞行模式验证离线查词与背词。

## 11. 已知限制
1. iOS 可能回收网站数据，建议定期导出备份。
2. 当前内置词典为 demo 数据，生产需要替换为合法授权词库。
3. 发音默认走系统 TTS，未集成完整离线音频资源包。

## 12. 后续迭代建议
1. 增加真实词典分片工具链（打包、校验、增量更新）。
2. 增加云同步（可选账号体系）。
3. 增加复习统计看板与学习周报。
4. 引入更精细的记忆模型（SM-2/FSRS）。
