import { createApp } from 'vue'
import App from './App.vue'
import { createDevframeHost } from './devframe-host'
import './styles.css'

createApp(App, { host: createDevframeHost() }).mount('#app')
