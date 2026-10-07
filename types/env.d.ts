/// <reference types="@nuxt/schema" />

// 纯前端服务模块通过构建期注入读取公开环境变量，这里补充最小类型声明。
declare const process: { env: Record<string, string | undefined> }
