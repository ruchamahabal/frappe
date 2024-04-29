<template>
	<div class="flex flex-row">
		<AppSidebar />
		<div class="flex flex-col grow">
			<Navbar />
			<router-view></router-view>
		</div>
	</div>
</template>

<script setup>
import AppSidebar from '@/components/AppSidebar.vue'
import Navbar from '@/components/Navbar.vue'

</script>