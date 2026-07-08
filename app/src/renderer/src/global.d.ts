import type { GraspApi } from '../../shared/types'

declare global {
  interface Window {
    grasp: GraspApi
  }
}

export {}
