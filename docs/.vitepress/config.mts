import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

export default withMermaid(
  defineConfig({
    base:
      process.env.BASE_PATH ||
      (process.env.GITHUB_ACTIONS ? '/embocraft/' : '/'),
    lang: 'zh-CN',
    title: 'EmboCraft',
    description: '独立的本地多人 3D 体素与具身智能体沙盒文档',
    ignoreDeadLinks: true,

    themeConfig: {
      logo: '/logo.svg',
      siteTitle: 'EmboCraft',

      nav: [
        { text: '首页', link: '/' },
        { text: '快速开始', link: '/guide/getting-started' },
        { text: '项目架构', link: '/guide/architecture' },
        { text: 'AI Agent', link: '/agent/players' },
      ],

      sidebar: [
        {
          text: '指南',
          items: [
            { text: '快速开始', link: '/guide/getting-started' },
            { text: '项目架构', link: '/guide/architecture' },
            { text: '详细架构图', link: '/guide/architecture-diagrams' },
          ],
        },
        {
          text: '协议',
          collapsed: false,
          items: [
            { text: '协议与扩展边界', link: '/protocol/overview' },
            { text: '聊天与附近语音', link: '/protocol/chat' },
          ],
        },
        {
          text: 'Agent',
          collapsed: false,
          items: [
            { text: '接入 AI 玩家', link: '/agent/players' },
            { text: '管理接口 (Gateway)', link: '/agent/gateway' },
            { text: '统一事件运行时', link: '/agent/runtime' },
          ],
        },
        {
          text: '语音',
          collapsed: false,
          items: [
            { text: '语音服务管理', link: '/voice/setup' },
            { text: '百炼实时语音', link: '/voice/aliyun-realtime' },
          ],
        },
        {
          text: '变更记录',
          collapsed: true,
          items: [
            { text: 'Pi 迁移与验收', link: '/changelog/pi-migration' },
            { text: '验证记录', link: '/changelog/validation' },
          ],
        },
      ],

      socialLinks: [
        {
          icon: 'github',
          link: 'https://github.com/lulabs-org/agent-voxel-world',
        },
      ],

      footer: {
        message: '基于 MIT 协议开源',
        copyright: 'Copyright © 2024 LuLabs',
      },

      search: {
        provider: 'local',
      },

      outline: {
        level: [2, 3],
        label: '目录',
      },

      docFooter: {
        prev: '上一页',
        next: '下一页',
      },

      darkModeSwitchLabel: '主题',
      lightModeSwitchTitle: '切换到浅色模式',
      darkModeSwitchTitle: '切换到深色模式',
      sidebarMenuLabel: '菜单',
      returnToTopLabel: '返回顶部',
      langMenuLabel: '更改语言',
    },

    markdown: {
      theme: {
        light: 'github-light',
        dark: 'github-dark',
      },
      lineNumbers: true,
    },

    vite: {
      server: {
        host: '127.0.0.1',
        port: 5174,
        strictPort: true,
      },
      optimizeDeps: {
        include: [
          'mermaid',
          'dayjs',
          '@braintree/sanitize-url',
          'cytoscape',
          'cytoscape-cose-bilkent',
        ],
      },
      resolve: {
        alias: [
          {
            find: /^dayjs$/,
            replacement: 'dayjs/esm',
          },
        ],
      },
    },
  }),
);
