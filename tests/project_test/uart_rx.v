//================================================================================
//
//  ███╗   ███╗███████╗██████╗  ██████╗███████╗██████╗ 
//  ████╗ ████║██╔════╝██╔══██╗██╔════╝██╔════╝██╔══██╗
//  ██╔████╔██║█████╗  ██████╔╝██║     █████╗  ██████╔╝
//  ██║╚██╔╝██║██╔══╝  ██╔══██╗██║     ██╔══╝  ██╔══██╗
//  ██║ ╚═╝ ██║███████╗██║  ██║╚██████╗███████╗██║  ██║
//  ╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝ ╚═════╝╚══════╝╚═╝  ╚═╝
//
//--------------------------------------------------------------------------------
//  Author      : Mercer
//  Module      : uart_rx
//  Description : UART receiver with parity check support
//  Wechat      : zxw895674551
//  Email       : alexmercer@outlook.com
//--------------------------------------------------------------------------------
//  Copyright (c) 2026 Mercer. All rights reserved.
//  Licensed under the MIT License.
//--------------------------------------------------------------------------------
//  Version History:
//  v1.0 - Initial release
//================================================================================
//  Instantiation Template
//================================================================================
/*
uart_rx #(
    .SYS_CLK_FREQ              (50_000_000     ),
    .BAUD_RATE                 (115200         ),
    .PARITY_TYPE               ("none"         ))
u_uart_rx (
    .clk                       (clk            ),
    .rst_n                     (rst_n          ),

    .rx_valid                  (rx_valid       ),
    .rx_ready                  (rx_ready       ),
    .rx_data                   (rx_data        ),

    .uart_rx                   (uart_rx        ));
*/

//================================================================================
//  Module Definition
//================================================================================

module uart_rx #(
    parameter SYS_CLK_FREQ  = 50_000_000,
    parameter BAUD_RATE     = 115200,
    parameter PARITY_TYPE   = "none"
)(
    input                   clk,
    input                   rst_n,

    output  wire            rx_valid,
    input   wire            rx_ready,
    output  wire [7:0]      rx_data,

    input                   uart_rx
);

    localparam BAUD_CNT = SYS_CLK_FREQ / BAUD_RATE;
    localparam PARITY_EN = PARITY_TYPE == "odd" || PARITY_TYPE == "even";

    reg                 rx_ff0;
    reg                 rx_ff1;
    reg                 rx_ff2;

    reg                 parity_bit;

    reg                 rx_busy;

    reg     [9:0]       baud_cnt;
    reg     [3:0]       bit_cnt;

    reg                 data_valid;
    reg     [7:0]       data_out;

    wire                serial_sync;
    wire                serial_fall;
    wire                handshake;
    wire                half_bit;
    wire                one_bit;
    wire                one_byte;
    wire                parity_odd;
    wire                parity_even;
    wire                parity_pass;

    assign serial_sync = rx_ff2;
    assign serial_fall = rx_ff2 & ~rx_ff1;
    assign handshake = rx_valid & rx_ready;
    assign half_bit = baud_cnt == BAUD_CNT / 2 - 1;
    assign one_bit = baud_cnt == BAUD_CNT - 1;
    assign one_byte = (bit_cnt == 8 + PARITY_EN) & one_bit;
    assign parity_odd = parity_bit == ^~data_out;
    assign parity_even = parity_bit == ^data_out;
    assign parity_pass = PARITY_TYPE == "odd" ? parity_odd : PARITY_TYPE == "even" ? parity_even : 1'b1;
    assign rx_valid = data_valid;
    assign rx_data = data_out;

    always @(posedge clk) begin
        if (!rst_n) begin
            rx_ff0 <= 1'b1;
            rx_ff1 <= 1'b1;
            rx_ff2 <= 1'b1;
        end else begin
            rx_ff0 <= uart_rx;
            rx_ff1 <= rx_ff0;
            rx_ff2 <= rx_ff1;
        end
    end

    always @(posedge clk) begin
        if (!rst_n) begin
            rx_busy <= 1'b0;
        end else begin
            rx_busy <= serial_fall ? 1'b1 : one_byte ? 1'b0 : rx_busy;
        end
    end

    always @(posedge clk) begin
        if (!rst_n) begin
            baud_cnt <= 10'd0;
        end else if (rx_busy) begin
            baud_cnt <= one_bit ? 10'd0 : baud_cnt + 1'b1;
        end
    end

    always @(posedge clk) begin
        if (!rst_n) begin
            bit_cnt <= 4'd0;
        end else if (one_bit) begin
            bit_cnt <= one_byte ? 4'd0 : bit_cnt + 1'd1;
        end
    end

    always @(posedge clk) begin
        if (!rst_n) begin
            data_out <= 8'd0;
            parity_bit <= 1'b0;
        end else if (half_bit) begin
            case (bit_cnt)
                4'd1: data_out[0] <= serial_sync;
                4'd2: data_out[1] <= serial_sync;
                4'd3: data_out[2] <= serial_sync;
                4'd4: data_out[3] <= serial_sync;
                4'd5: data_out[4] <= serial_sync;
                4'd6: data_out[5] <= serial_sync;
                4'd7: data_out[6] <= serial_sync;
                4'd8: data_out[7] <= serial_sync;
                4'd9: parity_bit <= serial_sync;
                default:;
            endcase
        end
    end

    always @(posedge clk) begin
        if (!rst_n) begin
            data_valid <= 1'b0;
        end else begin
            data_valid <= handshake ? 1'b0 : one_byte & parity_pass ? 1'b1 : data_valid;
        end
    end

endmodule
