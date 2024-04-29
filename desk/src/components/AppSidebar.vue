<template>
	<div class="relative bg-gray-50 flex h-full min-h-screen flex-col justify-between w-56 p-4">
		<div class="flex gap-2 items-center" v-if="currentModule" >
			<!-- <AppLogo class="h-6 w-6" />
			<span class="text-gray-800 text-xl font-semibold">Frappe</span> -->

			<Icon class="h-6 w-6" :name="currentModule.icon" />
			<span class="text-gray-800 text-xl font-semibold">{{ currentModule.label }}</span>
		</div>
	</div>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppLogo from '@/components/icons/AppLogo.vue'

import Icon from '@/components/Icon.vue'

import { createResource } from "frappe-ui"

const desktopModules = createResource({
	url: "frappe.desk.desktop.get_workspace_sidebar_items",
	auto: true,
})

const route = useRoute()

const currentModule = computed(() => {
	const module = route.params.module
	return desktopModules.data?.pages.find((page) => page.name.toLowerCase() === module)
})
</script>
