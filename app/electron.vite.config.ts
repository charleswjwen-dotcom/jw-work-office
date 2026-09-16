import { cpSync } from 'node:fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// 架构意图（勿删）：db-worker 以 Utility 进程独立加载 out/main/db-worker.js，
// 其中内联的 connection.ts 需要迁移目录（drizzle-kit 产物）才能建表。
// 历史上运行期靠 cwd 回退到 src/ 源码目录找迁移——dev/e2e 恰好 cwd=app/
// 而侥幸可用，打包后 cwd=/ 全候选落空，得到"零表空库 + db.ready 照常返回"
// 的静默僵尸态（验收期实测：所有 IPC 返回 DATA_LAYER_NOT_READY 且无线索）。
// 因此迁移必须随构建产物分发：构建结束时拷贝到 out/main/migrations，
// 使 connection.ts 的首选候选（相对 __dirname）在任何 cwd 下都命中。
function copyDbMigrations(): Plugin {
  return {
    name: 'copy-db-migrations',
    closeBundle() {
      cpSync(resolve('src/main/db/migrations'), resolve('out/main/migrations'), {
        recursive: true
      })
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyDbMigrations()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'db-worker': resolve('src/main/db/worker.ts'),
          'file-worker': resolve('src/main/files/worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()]
  }
})
