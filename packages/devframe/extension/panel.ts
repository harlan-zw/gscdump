import { createApp } from 'vue'
import App from '../app/App.vue'
import { createChromeHost } from './chrome-host'
import '../app/styles.css'

createApp(App, { host: createChromeHost(import.meta.env.GSCDUMP_ORIGIN) }).mount('#app')
