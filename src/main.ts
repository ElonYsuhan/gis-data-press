import { createApp, h } from 'vue'
import App from './App.vue'
import AppProviders from './app/AppProviders.vue'
import './style.css'

createApp({ render: () => h(AppProviders, null, { default: () => h(App) }) }).mount('#app')
