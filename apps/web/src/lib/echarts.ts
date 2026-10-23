// 按需引入 ECharts，减小图表分包体积
import { LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, MarkLineComponent, MarkAreaComponent, CanvasRenderer]);

export { echarts };
