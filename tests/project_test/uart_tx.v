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
//  Module      : uart_tx
//  Description : UART transmitter with configurable parity and trigger type
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
uart_tx #(
    .SYS_CLK_FREQ              (50_000_000     ),
    .BAUD_RATE                 (115200         ),
    .STOP_BIT_CNT              (1              ),
    .PARITY_TYPE               ("none"         ))
u_uart_tx (
    .clk                       (clk            ),
    .rst_n                     (rst_n          ),

    .tx_valid                  (tx_valid       ),
    .tx_ready                  (tx_ready       ),
    .tx_data                   (tx_data        ),

    .uart_tx                   (uart_tx        ));
*/

//================================================================================
//  Module Definition
//================================================================================

module uart_tx #(
    parameter SYS_CLK_FREQ  = 50_000_000,
    parameter BAUD_RATE     = 115200,
    parameter STOP_BIT_CNT  = 1,
    parameter PARITY_TYPE   = "none"
)(
    input                   clk,
    input                   rst_n,

    input                   tx_valid,
    output  wire            tx_ready,
    input   [7:0]           tx_data,

    output  wire            uart_tx
);

    localparam BAUD_CNT = SYS_CLK_FREQ / BAUD_RATE;
    localparam PARITY_EN = PARITY_TYPE == "odd" || PARITY_TYPE == "even";

    reg                 data_ready;
    reg     [7:0]       data_in;
    reg                 tx_reg;
    reg                 tx_busy;
    reg     [9:0]       baud_cnt;
    reg     [3:0]       bit_cnt;

    wire                handshake;
    wire                parity_odd;
    wire                parity_even;
    wire                parity_bit;
    wire                one_bit;
    wire                one_byte;

    assign handshake = tx_valid & tx_ready;
    assign parity_odd = ^~data_in;
    assign parity_even = ^data_in;
    assign parity_bit = PARITY_TYPE == "odd" ? parity_odd : PARITY_TYPE == "even" ? parity_even : 1'b1;
    assign one_bit = baud_cnt == BAUD_CNT - 1;
    assign one_byte = (bit_cnt == 8 + PARITY_EN + STOP_BIT_CNT) & one_bit;
    assign tx_ready = data_ready;
    assign uart_tx = tx_reg;

    always @(posedge clk) begin
        if (!rst_n) begin
            tx_busy <= 1'b0;
        end else begin
            tx_busy <= handshake ? 1'b1 : one_byte ? 1'b0 : tx_busy;
        end
    end

    always @(posedge clk) begin
        if (!rst_n) begin
            data_in <= 8'd0;
        end else if (handshake) begin
            data_in <= tx_data;
        end
    end

    always @(posedge clk) begin
        if (!rst_n)
            baud_cnt <= 10'd0;
        else if (tx_busy) begin
            baud_cnt <= one_bit ? 10'd0 : baud_cnt + 1'd1;
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
            tx_reg <= 1'b1;
        end else if (tx_busy) begin
            case (bit_cnt)
                4'd0:  tx_reg <= 1'b0;
                4'd1:  tx_reg <= data_in[0];
                4'd2:  tx_reg <= data_in[1];
                4'd3:  tx_reg <= data_in[2];
                4'd4:  tx_reg <= data_in[3];
                4'd5:  tx_reg <= data_in[4];
                4'd6:  tx_reg <= data_in[5];
                4'd7:  tx_reg <= data_in[6];
                4'd8:  tx_reg <= data_in[7];
                4'd9:  tx_reg <= parity_bit;
                default: tx_reg <= 1'b1;
            endcase
        end
    end

    always @(posedge clk) begin
        if (!rst_n) begin
            data_ready <= 1'b1;
        end else begin
            data_ready <= handshake ? 1'b0 : one_byte ? 1'b1 : data_ready;
        end
    end

endmodule
